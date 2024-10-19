import {
	id,
	concat,
	hexlify,
	AbiCoder,
	Interface,
	isCallException,
	resolveAddress,
	type ContractRunner,
	type TransactionRequest,
} from "ethers";

const ABI = new Interface([
	`error OffchainLookup(address sender, string[] urls, bytes request, bytes4 callback, bytes carry)`,
	`error OffchainTryNext(address sender)`,
]);

const UNANSWERED = id("OffchainLookupUnanswered()").slice(0, 10);

type OffchainSender = {
	sender: string;
};

type OffchainLookup = OffchainSender & {
	urls: string[];
	request: string;
	callback: string;
	carry: string;
};

export class CCIPReadRunner implements ContractRunner {
	constructor(readonly runner: ContractRunner, readonly maxAttempts = 20) {}
	get provider() {
		return this.runner.provider;
	}
	async call(tx0: TransactionRequest): Promise<string> {
		// if we don't need ccip, just use standard call()
		if (!tx0.to || !tx0.enableCcipRead) return this.runner.call!(tx0);
		// force resolve the target and remember it
		const origin = await resolveAddress(tx0.to);
		let lookup = await this._call(
			{
				...tx0, // call the original tx
				to: origin,
				enableCcipRead: false, // disable ccip-read
			},
			false // disable OffchainTryNext()
		);
		if (typeof lookup === "string") return lookup; // it answered immediately
		// [ERC-3668] sender must match
		if (lookup.sender !== origin) throw new Error("origin != sender");
		let index = 0;
		for (let n = this.maxAttempts; n > 0; n--) {
			let url: string;
			let response: string;
			if (index < lookup.urls.length) {
				// we still have endpoints to try
				url = lookup.urls[index++];
				try {
					// [ERC-3668] build request according
					const options: RequestInit = {};
					if (!url.includes("{data}")) {
						options.method = "POST";
						options.body = JSON.stringify({
							sender: origin,
							data: lookup.request,
						});
					}
					url = url.replaceAll("{data}", lookup.request);
					url = url.replaceAll("{sender}", origin);
					const res = await fetch(url, options); // call it
					// ignore res.status, assume json
					const { data } = await res.json();
					// [ERC-3668] extract {data}, ensure hex string
					response = hexlify(data);
				} catch (err) {
					continue;
				}
			} else {
				// we ran out of endpoints
				response = UNANSWERED;
			}
			// [ERC-3668] build callback response
			const data = concat([
				lookup.callback,
				AbiCoder.defaultAbiCoder().encode(
					["bytes", "bytes"],
					[response, lookup.carry]
				),
			]);
			const next = await this._call({ to: origin, data }, true);
			if (typeof next === "string") return next; // answered immediately
			// [ERC-3668] recursive, sender must still match
			if (next.sender !== origin) throw new Error("origin != sender");
			// if next is OffchainTryNext(), just continue
			// if next is a new OffchainLookup(), reset iterator and keep going
			if ("urls" in next) {
				index = 0;
				lookup = next;
			}
		}
		throw new Error(`'ccip read: max attempts (${this.maxAttempts})`);
	}

	async _call(
		tx: TransactionRequest,
		canNext: false
	): Promise<string | OffchainLookup>;
	async _call(
		tx: TransactionRequest,
		canNext: true
	): Promise<string | OffchainLookup | OffchainSender>;
	async _call(
		tx: TransactionRequest,
		canNext: boolean
	): Promise<string | OffchainLookup | OffchainSender> {
		try {
			return await this.runner.call!(tx);
		} catch (err) {
			if (!isCallException(err) || !err.data || err.data.length < 10) {
				throw err;
			}
			const error = ABI.parseError(err.data);
			if (error?.name === "OffchainLookup") {
				return <OffchainLookup>error.args.toObject();
			} else if (canNext && error?.name === "OffchainTryNext") {
				return <OffchainSender>error.args.toObject();
			}
			throw err;
		}
	}
}
