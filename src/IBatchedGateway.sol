// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

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
