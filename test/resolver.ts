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

type BatchedHTTPError = [code: bigint, message: string];

export type ENSRecord =
	| ["addr", arg?: BigNumberish]
	| ["text", arg: string]
	| ["contenthash" | "pubkey" | "name" | "dne"];

type URLookup = {
	offset: bigint;
	basenode: string;
	resolver: string;
	extended: boolean;
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

export async function deployUR(foundry: Foundry, file = "UR") {
	return foundry.deploy({
		file,
		args: [
			"0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e",
			["https://ccip-v2.ens.xyz"],
		],
	});
}

function fragFromRecord([type, arg]: ENSRecord) {
	const frag = ABI.getFunction(
		type === "addr"
			? arg === undefined
				? "addr(bytes32)"
				: "addr(bytes32,uint256)"
			: type
	);
	if (!frag) throw new Error(`unknown record type: ${type}`);
	return frag;
}

export function createResolve(UR: Contract) {
	return async (name: string, records: ENSRecord[]) => {
		name = ensNormalize(name);
		const dnsname = dnsEncode(name, 255);
		const node = namehash(name);
		const [
			{ basenode, resolver, extended, offset: bigOffset },
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
			name,
			dnsname,
			node,
			basename: toUtf8String(toUtf8Bytes(name).subarray(offset)),
			basenode,
			offset,
			resolver,
			extended,
			records: answers.map(({ bits, data }, i) => {
				const record = records[i];
				const error = !!(bits & 1n);
				const offchain = !!(bits & 2n);
				const batched = !!(bits & 4n);
				const frag = fragFromRecord(record);
				const ret: ParsedURResponse = {
					error,
					offchain,
					batched,
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
							const errors: BatchedHTTPError[] = desc.args[0];
							ret.err = new Error(
								`HTTPErrors[${errors.length}]: ${errors.map(
									([code, message]) => `${code}:${message}`
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
