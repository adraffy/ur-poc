import type { Foundry } from "@adraffy/blocksmith";
import {
	Interface,
	dnsEncode,
	namehash,
	ensNormalize,
	toUtf8Bytes,
	toUtf8String,
	type BigNumberish,
	type Contract,
} from "ethers";

const ABI = new Interface([
	"function addr(bytes32) external view returns (address)",
	"function addr(bytes32, uint256 coinType) external view returns (bytes)",
	"function text(bytes32, string key) external view returns (string)",
	"function contenthash(bytes32) external view returns (bytes)",
	"function name(bytes32) external view returns (string)",
	"function pubkey(bytes32) external view returns (bytes32 x, bytes32 y)",
	"function dne(bytes32) external view returns (string)", // not a real ENS profile
]);

const BATCHED_ABI = new Interface([
	"error HttpError((uint16 status, string message)[] errors)",
]);

export type ENSRecord =
	| ["addr", arg?: BigNumberish]
	| ["text", arg: string]
	| ["contenthash" | "pubkey" | "name" | "dne"];

type URLookup = {
	node: string;
	resolver: string;
	extended: boolean;
	offset: bigint;
};
type URResponse = { bits: bigint; data: string };
type URABIResult = [URLookup, URResponse[]];

type ParsedURResponse = {
	offchain: boolean;
	batched: boolean;
	error: boolean;
	data: string;
	frag: string;
	record: ENSRecord;
	err?: Error;
	result?: any[];
};

export async function deployUR(foundry: Foundry) {
	return foundry.deploy({
		file: "UR",
		args: [
			"0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e",
			["https://ccip-v2.ens.xyz"],
		],
	});
}

function fragFromRecord([frag, arg]: ENSRecord) {
	return frag === "addr"
		? arg === undefined
			? "addr(bytes32)"
			: "addr(bytes32,uint256)"
		: frag;
}

export function createResolve(UR: Contract) {
	return async (name: string, records: ENSRecord[]) => {
		name = ensNormalize(name);
		const dnsname = dnsEncode(name, 255);
		const node = namehash(name);
		const [
			{ node: basenode, resolver, extended, offset: bigOffset },
			answers,
		]: URABIResult = await UR.resolve(
			dnsname,
			records.map((record) => {
				const arg = record[1];
				return ABI.encodeFunctionData(
					fragFromRecord(record),
					arg === undefined ? [node] : [node, arg]
				);
			}),
			{ enableCcipRead: true }
		);
		const offset = Number(bigOffset);
		return {
			dnsname,
			node,
			basenode,
			offset,
			basename: toUtf8String(toUtf8Bytes(name).subarray(offset)),
			resolver,
			extended,
			records: answers.map(({ bits, data }, i) => {
				const record = records[i];
				const error = !!(bits & 1n);
				const offchain = !!(bits & 2n);
				const batched = !!(bits & 4n);
				const frag = ABI.getFunction(fragFromRecord(record))!;
				const ret: ParsedURResponse = {
					offchain,
					batched,
					error,
					record,
					frag: frag.format(),
					data,
				};
				if (!error) {
					try {
						ret.result = ABI.decodeFunctionResult(
							frag,
							data
						).toArray();
					} catch (err: any) {
						ret.err = err;
					}
				} else if (batched) {
					try {
						const desc = BATCHED_ABI.parseError(data);
						if (desc) {
							const errors = desc.args[0] as [
								code: bigint,
								message: string
							][];
							ret.err = new Error(
								`HTTPErrors[${errors.length}]: ${errors.map(
									([code, message]) => {
										return `${code}:${message}`;
									}
								)}`
							);
						}
					} catch (err) {}
				}
				return ret;
			}),
		};
	};
}
