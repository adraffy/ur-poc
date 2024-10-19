import { Foundry } from "@adraffy/blocksmith";
import { inspect } from "node:util";
import { createResolve, deployUR, type ENSRecord } from "./resolver.js";
import { CCIPReadRunner } from "../src/CCIPReadRunner.js";

// bun run fetch raffy.eth
// bun run fetch raffy.eth addr
// bun run fetch raffy.eth addr addr:60
// bun run fetch raffy.eth text:avatar addr:60 chash pubkey

const records: ENSRecord[] = process.argv.slice(3).map((spec) => {
	switch (spec) {
		case "dne":
		case "addr":
		case "pubkey":
			return [spec];
	}
	if (/^c(ontent)?hash\(\)$/.test(spec)) return ["contenthash"];
	let match = spec.match(/^addr:((?:0x)?\d+)$/);
	if (match) return ["addr", BigInt(match[1])];
	match = spec.match(/^text:(.*)$/);
	if (match) return ["text", match[1]];
	throw new Error(`unknown record: ${spec}`);
});
if (!records.length) {
	records.push(["addr", 60], ["text", "avatar"]);
}
console.log({ records });

const foundry = await Foundry.launch({
	fork: process.env.PROVIDER,
	infoLog: false,
});
const UR = await deployUR(foundry);
const resolve = createResolve(UR.connect(new CCIPReadRunner(foundry.provider)));
try {
	console.log(
		inspect(await resolve(process.argv[2], records), false, Infinity, true)
	);
} catch (err) {
	console.error(err);
}
await foundry.shutdown();
