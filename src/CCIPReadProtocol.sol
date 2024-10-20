// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

// https://eips.ethereum.org/EIPS/eip-3668
error OffchainLookup(address sender, string[] urls, bytes request, bytes4 callback, bytes carry);

// new stuff:
error OffchainLookupUnanswered();
error OffchainTryNext(address sender);

