import { Foundry } from "@adraffy/blocksmith";
import { EZCCIP } from "@resolverworks/ezccip";
import { serve } from "@resolverworks/ezccip/serve";
import { CCIPReadRunner } from "../src/CCIPReadRunner.js";
import { test, afterAll, expect } from "bun:test";
import { describe } from "./describe-fix.js";

const foundry = await Foundry.launch({
	infoLog: false,
});
afterAll(foundry.shutdown);

const ezccip = new EZCCIP();
ezccip.register("f() returns (string)", (_, context) => {
	let match = context.url?.match(/^\/(\d+)$/);
	if (match) throw { status: parseInt(match[1]) };
	if (context.url === "/malicious") return "0x12345";
	if (context.url === "/wrong") return ["not chonk"];
	return ["chonk"];
});
const ccip = await serve(ezccip, { protocol: "raw" });
afterAll(ccip.shutdown);

const runner = new CCIPReadRunner(foundry.provider);

const opts = { enableCcipRead: true };

describe("OffchainLookupUnanswered()", async () => {
	const contract = await foundry.deploy(`
		import "@src/CCIPReadProtocol.sol";
		contract C {
			function request() external view returns (string memory) {
				revert OffchainLookup(
					address(this),
					new string[](0),
					'',
					this.callback.selector,
					''
				);
			}
			function callback(bytes calldata ccip, bytes calldata) external view returns (string memory) {
				require(bytes4(ccip) == OffchainLookupUnanswered.selector);
				return "chonk";
			}
		}	
	`);
	test("old", () => {
		expect(contract.request(opts)).rejects.toThrow();
	});
	test("new", () => {
		expect(contract.connect(runner).request(opts)).resolves.toEqual(
			"chonk"
		);
	});
});

describe("OffchainTryNext()", async () => {
	const contract = await foundry.deploy({
		sol: `
			import "@src/CCIPReadProtocol.sol";
			contract C {
				string[] _urls;
				constructor(string[] memory urls) {
					_urls = urls;
				}
				function request() external view returns (string memory) {
					revert OffchainLookup(
						address(this),
						_urls,
						hex'${ezccip.findHandler("f")!.abi.encodeFunctionData("f", []).slice(2)}',
						this.callback.selector,
						bytes("CHONK")
					);
				}
				function callback(bytes memory ccip, bytes memory carry) external view returns (string memory) {
					try C(this).tryDecode(ccip) returns (
						string memory answer
					) {
						if (keccak256(bytes(answer)) == keccak256(bytes("chonk"))) {
							return string(carry);
						}
					} catch {
					}
					revert OffchainTryNext(address(this));
				}
				function tryDecode(bytes memory v) external view returns (string memory) {
					return abi.decode(v, (string));
				}
			}
		`,
		args: [
			[
				ccip.endpoint + "/wrong",
				ccip.endpoint + "/malicious",
				ccip.endpoint,
			],
		],
	});
	test("old", () => {
		expect(contract.request(opts)).rejects.toThrow();
	});
	test("new", () => {
		expect(contract.connect(runner).request(opts)).resolves.toEqual(
			"CHONK"
		);
	});
});
