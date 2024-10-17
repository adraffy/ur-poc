// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {ENS} from "@ensdomains/ens-contracts/contracts/registry/ENS.sol";
import {IExtendedResolver} from "@ensdomains/ens-contracts/contracts/resolvers/profiles/IExtendedResolver.sol";
import {BytesUtils} from "@ensdomains/ens-contracts/contracts/utils/BytesUtils.sol";

import "forge-std/console2.sol";

// https://eips.ethereum.org/EIPS/eip-3668
error OffchainLookup(
    address from,
    string[] urls,
    bytes request,
    bytes4 callback,
    bytes carry
);

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
    struct HttpErrorTuple {
        uint16 status;
        string message;
    }
    error HttpError(HttpErrorTuple[] errors);
}

uint256 constant ERROR_BIT = 1 << 0;
uint256 constant OFFCHAIN_BIT = 1 << 1;
uint256 constant BATCHED_BIT = 1 << 2;
uint256 constant RESOLVED_BIT = 1 << 3;

contract UR {
    error Unreachable(bytes name);
    error LengthMismatch();
    error InvalidCCIPRead();

    struct Response {
        uint256 bits;
        bytes data;
    }

    ENS immutable _ens;
    string[] _urls;

    constructor(ENS ens, string[] memory urls) {
        _ens = ens;
        _urls = urls;
    }

    function resolve(
        bytes memory name,
        bytes[] memory calls
    ) external view returns (Lookup memory lookup, Response[] memory res) {
        lookup = lookupResolver(name); // do ensip-15
        // console2.log("[node]");
        // console2.logBytes32(lookup.node);
        // console2.log(
        //     "[resolver=%s extended=%s, offset=%s]",
        //     lookup.resolver,
        //     lookup.extended,
        //     lookup.offset
        // );
        res = new Response[](calls.length);
        uint256 missing;
        for (uint256 i; i < res.length; i++) {
            bytes memory call = lookup.extended
                ? abi.encodeCall(IExtendedResolver.resolve, (name, calls[i]))
                : calls[i];
            (bool ok, bytes memory v) = lookup.resolver.staticcall(call);
            if (ok && lookup.extended) v = abi.decode(v, (bytes)); // unwrap resolve
            res[i].data = v;
            if (!ok && bytes4(v) == OffchainLookup.selector) {
                res[i].bits |= OFFCHAIN_BIT;
                calls[missing++] = call;
                // console2.log("[missing #%s]", missing);
                // console2.logBytes(call);
            } else {
                if (!ok) res[i].bits |= ERROR_BIT;
                res[i].bits |= RESOLVED_BIT;
            }
        }
        //console2.log("[missing=%s]", missing);
        if (lookup.wrappable) {
            if (missing > 1) {
                assembly {
                    mstore(calls, missing)
                }
                bytes memory multi = abi.encodeCall(
                    ResolveMulticall.multicall,
                    (calls)
                );
                (bool ok, bytes memory v) = lookup.resolver.staticcall(
                    abi.encodeCall(IExtendedResolver.resolve, (name, multi))
                );
                if (ok) {
                    _processMulticallAnswers(res, v);
                } else if (bytes4(v) == OffchainLookup.selector) {
                    _revertWrappedOffchain(
                        v,
                        res,
                        lookup,
                        lookup.resolver,
                        true
                    );
                }
            } else if (missing == 1) {
                uint256 i = _requireFirstUnresolved(res, 0);
                _revertWrappedOffchain(
                    res[i].data,
                    res,
                    lookup,
                    lookup.resolver,
                    false
                );
            }
        }
        if (missing > 0) {
            _revertBatchedGateway(res, lookup);
        }
    }

    struct Lookup {
        uint256 offset;
        bytes32 node;
        address resolver;
        bool extended;
        bool wrappable;
    }

    function lookupResolver(
        bytes memory name
    ) internal view returns (Lookup memory lookup) {
        unchecked {
            while (true) {
                lookup.node = BytesUtils.namehash(name, lookup.offset);
                lookup.resolver = _ens.resolver(lookup.node);
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
                // until ccip can survive 4XX we can only call resolve(multicall)
                // on resolvers that can handle it
                lookup.wrappable = _supportsInterface(
                    lookup.resolver,
                    0x73302a25
                );
            } else if (lookup.offset != 0) {
                revert Unreachable(name);
            }
        }
    }

    struct WrappedCarry {
        address sender;
        bytes request;
        bytes4 selector;
        bytes carry;
        Response[] res;
        Lookup lookup;
        bool multi;
    }

    function _revertWrappedOffchain(
        bytes memory revertData,
        Response[] memory res,
        Lookup memory lookup,
        address caller,
        bool multi
    ) internal view {
        (
            address sender,
            string[] memory urls,
            bytes memory request,
            bytes4 selector,
            bytes memory carry
        ) = abi.decode(
                _slice(revertData, 4),
                (address, string[], bytes, bytes4, bytes)
            );
        if (caller != sender) revert InvalidCCIPRead(); // caller != sender
        revert OffchainLookup(
            address(this),
            urls,
            request,
            this.wrappedOffchainCallback.selector,
            abi.encode(
                WrappedCarry(
                    sender,
                    request,
                    selector,
                    carry,
                    res,
                    lookup,
                    multi
                )
            )
        );
    }

    function wrappedOffchainCallback(
        bytes memory ccip,
        bytes memory carry
    ) external view returns (Lookup memory lookup, Response[] memory res) {
        WrappedCarry memory wrapped = abi.decode(carry, (WrappedCarry));
        (res, lookup) = (wrapped.res, wrapped.lookup);
        (bool ok, bytes memory v) = wrapped.sender.staticcall(
            abi.encodeWithSelector(wrapped.selector, ccip, wrapped.carry)
        );
        if (wrapped.multi) {
            if (ok) {
                _processMulticallAnswers(res, v);
            } else {
                _revertBatchedGateway(res, lookup);
            }
        } else {
            if (bytes4(wrapped.request) == IExtendedResolver.resolve.selector) {
                v = abi.decode(v, (bytes)); // unwrap resolve()
            }
            uint256 i = _requireFirstUnresolved(res, 0);
            if (!ok && bytes4(v) == OffchainLookup.selector) {
                _revertWrappedOffchain(v, res, lookup, wrapped.sender, false);
            } else {
                res[i].data = v;
                res[i].bits |= RESOLVED_BIT;
                if (!ok) res[i].bits |= ERROR_BIT;
            }
        }
    }

    // batched gateway

    function _revertBatchedGateway(
        Response[] memory res,
        Lookup memory lookup
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
            res[i].bits |= BATCHED_BIT;
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
            abi.encode(res, lookup) // batchedCarry
        );
    }

    function batchedGatewayCallback(
        bytes memory ccip,
        bytes memory batchedCarry
    ) external view returns (Lookup memory lookup, Response[] memory res) {
        (res, lookup) = abi.decode(batchedCarry, (Response[], Lookup));
        (bool[] memory failures, bytes[] memory responses) = abi.decode(
            ccip,
            (bool[], bytes[])
        );
        if (failures.length != responses.length) revert LengthMismatch();
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
            _revertBatchedGateway(res, lookup);
        }
    }

    // utils

    function _processMulticallAnswers(
        Response[] memory res,
        bytes memory encoded
    ) internal pure {
        bytes[] memory answers = abi.decode(encoded, (bytes[]));
        uint256 expected;
        for (uint256 i; i < res.length; i++) {
            if ((res[i].bits & RESOLVED_BIT) == 0) {
                res[i].bits |= RESOLVED_BIT;
                bytes memory v = answers[expected++];
                if ((v.length & 31) != 0) {
                    res[i].bits |= ERROR_BIT;
                    res[i].data = v;
                } else {
                    res[i].data = abi.decode(v, (bytes)); // unwrap resolve()
                }
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

    function _requireFirstUnresolved(
        Response[] memory res,
        uint256 start
    ) internal pure returns (uint256) {
        for (; start < res.length; start++) {
            if ((res[start].bits & RESOLVED_BIT) == 0) {
                return start;
            }
        }
        revert InvalidCCIPRead(); // "expected unresolved"
    }
}
