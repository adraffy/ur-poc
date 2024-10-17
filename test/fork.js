import {Foundry} from '@adraffy/blocksmith';
import {deployUR} from './resolver.js';
import {test, after} from 'node:test';
import assert from 'assert/strict';

const foundry = await Foundry.launch({
	fork: 'https://rpc.ankr.com/eth'
});
after(foundry.shutdown);

//foundry.provider.on('debug', e => console.log(e));

const {resolve} = await deployUR(foundry);

test('empty', async () => {
	const info = await resolve('raffy.eth', []);
	assert.equal(info.answers.length, 0);
});

test('does not exist', async T => {
	assert.rejects(() => resolve('_dne123', [['addr', 60], ['text', 'avatar']]));
});

test('vitalik.eth', async T => {
	const info = await resolve(T.name, [['addr', 60], ['contenthash']]);
	assert.equal(info.answers[0].offchain, false);
	assert.equal(info.answers[0].batched, false);
	assert.equal(info.answers[0].result[0], '0xd8da6bf26964af9d7eed9e03e53415d37aa96045');

	assert.equal(info.answers[1].offchain, false);
	assert.equal(info.answers[1].batched, false);
	assert.equal(info.answers[1].result[0], '0xe30101701220c63c414f20f36e0e7ab0ae1ec9d74178c37701441e3d1f04c7a463fbbab8055f');
});

test('adraffy.cb.id', async T => {
	const info = await resolve(T.name, [['addr', 60], ['addr', 0]]);
	assert.equal(info.basename, 'cb.id');
	
	assert.equal(info.answers[0].offchain, true);
	assert.equal(info.answers[0].batched, true);
	assert.equal(info.answers[0].result[0], '0xc973b97c1f8f9e3b150e2c12d4856a24b3d563cb');

	assert.equal(info.answers[1].offchain, true);
	assert.equal(info.answers[1].batched, true);
	assert.equal(info.answers[1].result[0], '0x00142e6414903e4b24d05132352f71b75c165932a381');
});

test('raffy.base.eth', async T => {
	const info = await resolve(T.name, [['addr', 60], ['text', 'avatar']]);
	assert.equal(info.answers[0].offchain, true);
	assert.equal(info.answers[0].batched, true);
	assert.equal(info.answers[0].result[0], '0x51050ec063d393217b436747617ad1c2285aeeee');

	assert.equal(info.answers[1].offchain, true);
	assert.equal(info.answers[1].batched, true);
	assert.equal(info.answers[1].result[0], 'https://zku9gdedgba48lmr.public.blob.vercel-storage.com/basenames/avatar/raffy.base.eth/1724307217031/960_Circle-mVoi3vgDymZBskACj8s0gIKKLxcNmb.jpg');
});

test('TOR(hybrid): raffy.eth', async () => {
	const info = await resolve('raffy.eth', [['addr', 60], ['text', 'location']]);
	assert.equal(info.answers[0].offchain, false);
	assert.equal(info.answers[0].batched, false);
	assert.equal(info.answers[0].result[0], '0x51050ec063d393217b436747617ad1c2285aeeee');
	
	assert.equal(info.answers[1].offchain, true);
	assert.equal(info.answers[1].batched, true);
	assert.equal(info.answers[1].result[0], 'Hello from TheOffchainGateway.js!');
});

test('TOR(onchain): raffy.eth', async () => {
	const info = await resolve('raffy.eth', [['addr', 60], ['text', 'com.twitter']]);
	assert.equal(info.answers[0].offchain, false);
	assert.equal(info.answers[1].offchain, false);
});

test('TOR(offchain): eth.coinbase.tog.raffy.eth', async () => {
	const info = await resolve('eth.coinbase.tog.raffy.eth', [['text', 'url']]);
	assert.equal(info.basename, 'tog.raffy.eth');

	assert.equal(info.answers[0].offchain, true);
	assert.equal(info.answers[0].result[0], 'https://www.coinbase.com/price/eth');
});

test('DNS: ezccip.raffy.xyz', async () => {
	const info = await resolve('ezccip.raffy.xyz', [['text', 'name'], ['text', 'url']]);
	assert.equal(info.basename, 'raffy.xyz');

	assert.equal(info.answers[0].offchain, true);
	assert.equal(info.answers[1].offchain, true);
	
});

