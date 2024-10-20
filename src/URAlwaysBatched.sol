// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {ENS} from "@ensdomains/ens-contracts/contracts/registry/ENS.sol";
import {IExtendedResolver} from "@ensdomains/ens-contracts/contracts/resolvers/profiles/IExtendedResolver.sol";
import {BytesUtils} from "@ensdomains/ens-contracts/contracts/utils/BytesUtils.sol";
import {OffchainLookup} from "./CCIPReadProtocol.sol";

interface ResolveMulticall {
    function multicall(bytes[] calldata) external view returns (bytes[] memory);
}

interface BatchedGateway {
    struct Query {
        address target;
        string[] urls;
        bytes data;
    }
    function query(
        Query[] memory
    ) external view returns (bool[] memory failures, bytes[] memory responses);
}

uint256 constant ERROR_BIT = 1 << 0; // resolution failed
uint256 constant OFFCHAIN_BIT = 1 << 1; // reverted OffchainLookup
uint256 constant BATCHED_BIT = 1 << 2; // used Batched Gateway
uint256 constant RESOLVED_BIT = 1 << 3; // resolution finished (internal flag)

contract URAlwaysBatched {
    error Unreachable(bytes name);
    error LengthMismatch();
    error InvalidCCIPRead();

    ENS immutable _ens;
    string[] _urls;

    constructor(ENS ens, string[] memory urls) {
        _ens = ens;
        _urls = urls;
    }

    struct Response {
        uint256 bits;
        bytes data;
    }

    function resolve(
        bytes memory name,
        bytes[] memory calls
    ) external view returns (Lookup memory lookup, Response[] memory res) {
        lookup = lookupResolver(name); // do ensip-10
        res = new Response[](calls.length); // create result storage
        uint256 missing; // count how many offchain
        for (uint256 i; i < res.length; i++) {
            bytes memory call = lookup.extended
                ? abi.encodeCall(IExtendedResolver.resolve, (name, calls[i]))
                : calls[i];
            (bool ok, bytes memory v) = lookup.resolver.staticcall(call); // call it
            if (ok && lookup.extended) v = abi.decode(v, (bytes)); // unwrap if wildcard
            res[i].data = v;
            if (!ok && bytes4(v) == OffchainLookup.selector) {
                res[i].bits |= OFFCHAIN_BIT; // mark this result as offchain
                calls[missing++] = calls[i]; // assemble calldata for resolve(multicall)
            } else {
                if (!ok) res[i].bits |= ERROR_BIT; // mark this as a failure
                res[i].bits |= RESOLVED_BIT; // the answer was onchain, we're done
            }
        }
        if (missing > 1) {
            // multiple records were missing, try resolve(multicall)
            assembly {
                mstore(calls, missing) // truncate
            }
            bytes memory multi = abi.encodeCall(
                ResolveMulticall.multicall,
                (calls)
            );
            (bool ok, bytes memory v) = lookup.resolver.staticcall(
                abi.encodeCall(IExtendedResolver.resolve, (name, multi))
            );
            if (!ok && bytes4(v) == OffchainLookup.selector) {
                Response[] memory bundle = new Response[](1);
                bundle[0].bits = OFFCHAIN_BIT;
                bundle[0].data = v;
                _markAsBatched(res);
                _revertBatchedGateway(lookup, bundle, res);
            }
        }
        if (missing > 0) {
            _markAsBatched(res);
            _revertBatchedGateway(lookup, res, new Response[](0));
        }
    }

    struct Lookup {
        uint256 offset; // byte offset into name
        bytes32 basenode;
        address resolver;
        bool extended; // if true, use resolve()
    }

    function lookupResolver(
        bytes memory name
    ) public view returns (Lookup memory lookup) {
        unchecked {
            while (true) {
                lookup.basenode = BytesUtils.namehash(name, lookup.offset);
                lookup.resolver = _ens.resolver(lookup.basenode);
                if (lookup.resolver != address(0)) break;
                uint256 len = uint8(name[lookup.offset]);
                if (len == 0) revert Unreachable(name);
                lookup.offset += 1 + len;
            }
            if (
                _supportsInterface(
                    lookup.resolver,
                    type(IExtendedResolver).interfaceId
                )
            ) {
                lookup.extended = true;
            } else if (lookup.offset != 0) {
                revert Unreachable(name);
            }
        }
    }

    // batched gateway

    function _revertBatchedGateway(
        Lookup memory lookup,
        Response[] memory res,
        Response[] memory alt
    ) internal view {
        BatchedGateway.Query[] memory queries = new BatchedGateway.Query[](
            res.length
        );
        uint256 missing;
        for (uint256 i; i < res.length; i++) {
            if ((res[i].bits & RESOLVED_BIT) != 0) continue;
            (
                address sender,
                string[] memory urls,
                bytes memory request,
                ,

            ) = abi.decode(
                    _slice(res[i].data, 4),
                    (address, string[], bytes, bytes4, bytes)
                );
            queries[missing++] = BatchedGateway.Query(sender, urls, request);
        }
        assembly {
            mstore(queries, missing)
        }
        revert OffchainLookup(
            address(this),
            _urls,
            abi.encodeCall(BatchedGateway.query, (queries)),
            this.batchedGatewayCallback.selector,
            abi.encode(lookup, res, alt) // batchedCarry
        );
    }

    function batchedGatewayCallback(
        bytes memory ccip,
        bytes memory batchedCarry
    ) external view returns (Lookup memory lookup, Response[] memory res) {
        Response[] memory multi;
        (lookup, res, multi) = abi.decode(
            batchedCarry,
            (Lookup, Response[], Response[])
        );
        (bool[] memory failures, bytes[] memory responses) = abi.decode(
            ccip,
            (bool[], bytes[])
        );
        if (failures.length != responses.length) revert LengthMismatch();
        if (multi.length > 0 && failures[0]) {
            // this was a failed resolve(multicall) attempt
            // try doing the calls separately
            _revertBatchedGateway(lookup, multi, new Response[](0));
        }
        bool again;
        uint256 expected;
        for (uint256 i; i < res.length; i++) {
            if ((res[i].bits & RESOLVED_BIT) != 0) continue;
            if (failures[expected]) {
                res[i].bits |= ERROR_BIT | RESOLVED_BIT;
                res[i].data = responses[expected];
            } else {
                (
                    address sender,
                    ,
                    bytes memory request,
                    bytes4 selector,
                    bytes memory carry
                ) = abi.decode(
                        _slice(res[i].data, 4),
                        (address, string[], bytes, bytes4, bytes)
                    );

                (bool ok, bytes memory v) = sender.staticcall(
                    abi.encodeWithSelector(selector, responses[expected], carry)
                );
                if (
                    ok && bytes4(request) == IExtendedResolver.resolve.selector
                ) {
                    v = abi.decode(v, (bytes)); // unwrap resolve()
                }
                res[i].data = v;
                if (!ok && bytes4(v) == OffchainLookup.selector) {
                    again = true;
                } else {
                    if (!ok) res[i].bits |= ERROR_BIT;
                    res[i].bits |= RESOLVED_BIT;
                }
            }
            expected++;
        }
        if (expected != failures.length) revert LengthMismatch();
        if (again) {
            _revertBatchedGateway(lookup, res, multi);
        }
        if (multi.length > 0) {
            if ((res[0].bits & ERROR_BIT) != 0) {
                // server responded for resolve(multicall)
                // but contract rejected it
                // we could propagate the error to all of the responses
                //or resolve them separately <== chose this option
                _revertBatchedGateway(lookup, multi, new Response[](0));
            } else {
                // successful resolve(multicall)
                _processMulticallAnswers(multi, res[0].data);
                res = multi;
            }
        }
    }

    // utils

    function _markAsBatched(Response[] memory res) internal pure {
        for (uint256 i; i < res.length; i++) {
            if ((res[i].bits & OFFCHAIN_BIT) != 0) {
                res[i].bits |= BATCHED_BIT;
            }
        }
    }

    function _processMulticallAnswers(
        Response[] memory res,
        bytes memory encoded
    ) internal pure {
        bytes[] memory answers = abi.decode(encoded, (bytes[]));
        uint256 expected;
        for (uint256 i; i < res.length; i++) {
            if ((res[i].bits & RESOLVED_BIT) == 0) {
                bytes memory v = answers[expected++];
                res[i].data = v;
                if ((v.length & 31) != 0) res[i].bits |= ERROR_BIT;
                res[i].bits |= RESOLVED_BIT;
            }
        }
        if (expected != answers.length) revert LengthMismatch();
    }

    function _supportsInterface(
        address a,
        bytes4 selector
    ) internal view returns (bool ret) {
        try IERC165(a).supportsInterface{gas: 30000}(selector) returns (
            bool quacks
        ) {
            ret = quacks;
        } catch {}
    }

    function _slice(
        bytes memory src,
        uint256 skip
    ) internal pure returns (bytes memory ret) {
        ret = abi.encodePacked(src);
        assembly {
            mstore(add(ret, skip), sub(mload(ret), skip))
            ret := add(ret, skip)
        }
    }
}
