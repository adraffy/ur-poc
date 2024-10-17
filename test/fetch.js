import {Foundry} from '@adraffy/blocksmith';
import {inspect} from 'node:util';
import {deployUR} from './resolver.js';

const records = process.argv.slice(3).map(s => {
	let match = s.match(/^addr:((?:0x)?\d+)$/);
	if (match) return ['addr', BigInt(match[1])];
	match = s.match(/^text:(.*)$/);
	if (match) return ['text', match[1]];
	if (/^c(ontent)?hash\(\)$/.test(s)) return ['contenthash'];
	throw new Error(`unknown record: ${s}`);
});
if (!records.length) {
	records.push(['addr', 60], ['text', 'avatar']);
}
console.log({records});

const foundry = await Foundry.launch({
	fork: 'https://rpc.ankr.com/eth',
	infoLog: false,
});
const {resolve} = await deployUR(foundry);
try {
	console.log(inspect(await resolve(process.argv[2], records), false, Infinity, true));
} catch (err) {
	console.error(err);
}
await foundry.shutdown();
