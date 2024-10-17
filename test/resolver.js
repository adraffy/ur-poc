import {Interface, dnsEncode, namehash, ensNormalize, toUtf8Bytes, toUtf8String} from 'ethers';

const ABI = new Interface([
	'function addr(bytes32, uint256 coinType) external view returns (bytes)',
	'function text(bytes32, string key) external view returns (string)',
	'function contenthash(bytes32) external view returns (bytes)',
	'function name(bytes32) external view returns (string)',
]);

export async function deployUR(foundry) {
	const UR = await foundry.deploy({
		file: 'UR',
		args: ['0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e', ['https://ccip-v2.ens.xyz']]
	});
	async function resolve(name, records) {
		name = ensNormalize(name);
		const dnsname = dnsEncode(name, 255);
		const node = namehash(name);
		const [{node: basenode, resolver, extended, offset}, answers] = await UR.resolve(dnsname, records.map(([frag, arg]) => {
			let args = [node];
			if (arg !== undefined) {
				args.push(arg);
			}
			return ABI.encodeFunctionData(frag, args);
		}), {enableCcipRead: true});
		return {
			dnsname,
			node,
			basenode,
			//offset,
			basename: toUtf8String(toUtf8Bytes(name).subarray(Number(offset))),
			resolver,
			extended,
			answers: answers.map(([bits, data], i) => {
				const [frag, arg] = records[i];
				const error = !!(bits & 1n);
				const ret = {
					// bits,
					offchain: !!(bits & 2n),
					batched: !!(bits & 3n),
					error,
					frag, // frag: ABI.getFunction(frag).format(),
					arg,
					data
				};
				if (error) {
					ret.error = true;
				} else {
					try {
						ret.result = ABI.decodeFunctionResult(frag, data);	
					} catch (err) {
						ret.error = err;	
					}
				}
				return ret;
			})
		}
	}

	return {UR, resolve};
}
