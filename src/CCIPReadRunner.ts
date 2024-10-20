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

function isLookup(x: OffchainLookup | OffchainSender): x is OffchainLookup {
	return "urls" in x;
}

export class CCIPReadRunner implements ContractRunner {
	constructor(readonly runner: ContractRunner, readonly maxAttempts = 20, readonly debug = false) {}
	get provider() {
		return this.runner.provider;
	}
	async call(tx: TransactionRequest): Promise<string> {
		// if we don't need ccip, just use standard call()
		if (!tx.to || !tx.enableCcipRead) return this.runner.call!(tx);
		// force resolve the target and remember it
		const origin = await resolveAddress(tx.to);
		let answer = await this._call({
			...tx, // call the original tx
			to: origin,
			enableCcipRead: false, // disable ccip-read
		});
		if (typeof answer === "string") return answer; // it answered immediately
		// [ERC-3668] sender must match
		if (answer.sender !== origin) throw new Error("origin != sender");
		if (!isLookup(answer)) throw new Error("unexpected next()");
		let index = 0;
		let lookup = answer;
		for (let n = this.maxAttempts; n > 0; n--) {
			let url: string;
			let response: string;
			if (index < lookup.urls.length) {
				// we still have endpoints to try
				url = lookup.urls[index++];
				try {
					// [ERC-3668] build request
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
					if (response == UNANSWERED) continue; // not allowed
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
			answer = await this._call({ to: origin, data });
			if (typeof answer === "string") return answer; // answered immediately
			// [ERC-3668] recursive, sender must still match
			if (answer.sender !== origin) throw new Error("origin != sender");
			// if next is OffchainTryNext(), just continue
			// if next is a new OffchainLookup(), reset iterator and keep going
			if (isLookup(answer)) {
				index = 0;
				lookup = answer;
			} else if (response === UNANSWERED) {
				throw new Error("unexpected next()"); // next() at end makes no sense
			}
		}
		throw new Error(`'ccip read: max attempts (${this.maxAttempts})`);
	}

	async _call(
		tx: TransactionRequest
	): Promise<string | OffchainLookup | OffchainSender> {
		try {
			return await this.runner.call!(tx);
		} catch (err) {
			// propagate non-call or unparsable call errors
			if (!isCallException(err) || !err.data || err.data.length < 10) {
				throw err;
			}
			try {
				const error = ABI.parseError(err.data);
				switch (error?.name) {
					case "OffchainLookup":
						return error.args.toObject() as OffchainLookup;
					case "OffchainTryNext":
						return error.args.toObject() as OffchainSender;
				}
			} catch (parseError) {}
			throw err;
		}
	}
}
