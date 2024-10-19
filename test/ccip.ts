import { Foundry } from "@adraffy/blocksmith";
import { createResolve, deployUR, type ENSRecord } from "./resolver.js";
import { CCIPReadRunner } from "../src/CCIPReadRunner.js";

const foundry = await Foundry.launch({
	fork: process.env.PROVIDER,
	infoLog: false,
});
const UR = await deployUR(foundry);

const name = "raffy.base.eth";
const records: ENSRecord[] = [
	["addr", 60],
	["text", "description"],
];

try {
	const resolve = createResolve(UR);
	await resolve(name, records);
} catch (err: any) {
	// this blows up because coinbase ccip-read server throws 404
	// when we attempt resolve(multicall)
	console.log(err.shortMessage);
}

const resolve = createResolve(UR.connect(new CCIPReadRunner(foundry.provider)));
console.log(await resolve(name, records));

await foundry.shutdown();
