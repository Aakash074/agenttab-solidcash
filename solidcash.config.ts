import { defineConfig } from '@solidcash/solidhat/config';

export default defineConfig({
  paths: {
    contracts: 'contracts',
    artifacts: 'artifacts',
    tests: 'test',
  },
  // Native SolidCash mode (no evmCompat): compact Script ABI, sha256 selectors, smallest bytecode.
  compiler: {},
  typegen: {
    targets: [{ target: 'ethers6', layout: 'typechain', outDir: 'typechain-types' }],
  },
  mnemonic: process.env.SOLIDCASH_MNEMONIC,
  accounts: { count: 1, satoshis: 100_000_000n },
  networks: {
    // The mock runs under real BCH limits (10,000-byte inputs, 128-byte commitments, dust), so a green test
    // and a compiled artifact mean the same thing they would on chipnet/mainnet.
    mock: {
      type: 'mock',
      policy: { enforceDust: true },
      consensus: { maximumInputBytes: 10_000, maximumStackItemBytes: 10_000, maximumTransactionBytes: 100_000, maximumNftCommitmentBytes: 128 },
    },
    regtest: {
      type: 'regtest',
      rpc: {
        url: process.env.REGTEST_RPC_URL ?? 'http://127.0.0.1:18443',
        user: process.env.REGTEST_RPC_USER ?? 'user',
        password: process.env.REGTEST_RPC_PASSWORD ?? 'password',
      },
    },
    chipnet: { type: 'electrum', network: 'chipnet', mnemonic: process.env.SOLIDCASH_MNEMONIC_CHIPNET },
    mainnet: { type: 'electrum', network: 'mainnet', mnemonic: process.env.SOLIDCASH_MNEMONIC_MAINNET },
  },
  defaultNetwork: 'mock',
});
