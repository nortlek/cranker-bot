// Canonical deployment observed at block 26338413. Never populated from the frontend at runtime.
export const APEBALL_PINS = {
  "game": {
    "address": "0xb3388F9AdD2ea181fB578e18C324847D2F097Ab6",
    "hash": "0xdb07e53745e5b393f502ff683186cdceedfd20c9574d6b00368133e3233376c4"
  },
  "vault": {
    "address": "0xbA89F58e2ba3C15D63F4468b448C6e997c1F61dE",
    "hash": "0x9f308dceb25e9f66351a81d6e98c48a80414043b520cfc3af309588b910cef62"
  },
  "burner": {
    "address": "0x44F931cE249247E62fa4D311fBeaF3b2Cf68e2a7",
    "hash": "0x514d3a1a6f6b6e0aaef83d4d333a0a3ad3f211c141230215be4b86d87e1d3b13"
  },
  "poolOwner": {
    "address": "0x808D3C32a9E51633CFb98b21A101501D8D50bF20",
    "hash": "0x69ac120802c7fcb42e57cc58711add66b1f9b9bb12a93f722d4d57fbbec5a255"
  },
  "hook": {
    "address": "0xF4B101Ea2008a01F7944B019109E7D22095Ea0cC",
    "hash": "0x3493af6146df29fa3cfd5520f0cb7fdee2f6533490a643ec522220d066cd1772"
  },
  "token": {
    "address": "0x0Bbac44597b1cE9A212C00D46874ee74500D9bE2",
    "hash": "0x2aa1ef3de045f5ce2c88a46ec045a766f38a5d570ed637b0e1b07e8ad6208a83"
  },
  "adapter": {
    "address": "0x4608def184aeD3875977FEC309D274c6FE86f815",
    "hash": "0xb332cf5c04f8ca839dbdead60d554dcb6ee75c44def318922d0cc8b82021f5fd"
  },
  "collection": {
    "address": "0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D",
    "hash": "0x0ba5e25e74d81bab327110c8d8b44320f50ad5c3e91a546a5c5a9b605cf653b3"
  },
  "factory": {
    "address": "0xF5A3A153164791AB579C3d9ba5DBECf7cDfd300c",
    "hash": "0x7defffa3d081aef4ac1739a0dde22f38f191e89c6db225d9589b54c07cd29c3d"
  },
  "pool": {
    "address": "0xAACB94216eB83e62D9f1160A38f35A9bE9C778F7",
    "hash": "0x9f2aab3aea62e4fdcc83fdd04f3ad449db0332570756a2a12aea730224086d4c"
  },
  "shapes": {
    "address": "0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0",
    "hash": "0x5128789aebafbd129f209fc3d84928373b7c9fa07d1721fbc71ee92a412387d7"
  },
  "packs": {
    "address": "0xBa48517Cb5Fa86430582898FD07B7E9D80cD1815",
    "hash": "0x4eb67a259490c9aed0ae11721027513150120290e7094ab1b627ef24124420f6"
  },
  "expectedImplementation": {
    "address": "0xEaa4d032908A9734a2c7939c0D211c35ad51eb31",
    "hash": "0x84dee03dd3af8ee9fb96df379991b881988526db09cb7e294c136fedf9a011c5"
  },
  "poolManager": {
    "address": "0x000000000004444c5dc75cB358380D2e3dE08A90",
    "hash": "0x785f1014552b7ce7d5fb7d0c970ca60edee94fd00425d7ca21609acac7ce1293"
  }
} as const;
export const APEBALL_LINKS = [
  {
    "from": "game",
    "method": "factory",
    "address": "0xF5A3A153164791AB579C3d9ba5DBECf7cDfd300c"
  },
  {
    "from": "game",
    "method": "pool",
    "address": "0xAACB94216eB83e62D9f1160A38f35A9bE9C778F7"
  },
  {
    "from": "game",
    "method": "poolOwner",
    "address": "0x808D3C32a9E51633CFb98b21A101501D8D50bF20"
  },
  {
    "from": "game",
    "method": "vault",
    "address": "0xbA89F58e2ba3C15D63F4468b448C6e997c1F61dE"
  },
  {
    "from": "game",
    "method": "burner",
    "address": "0x44F931cE249247E62fa4D311fBeaF3b2Cf68e2a7"
  },
  {
    "from": "poolOwner",
    "method": "shapes",
    "address": "0x6fE9193276bF7aBCbEE44AB7aFd717d637D6FAf0"
  },
  {
    "from": "poolOwner",
    "method": "packs",
    "address": "0xBa48517Cb5Fa86430582898FD07B7E9D80cD1815"
  },
  {
    "from": "poolOwner",
    "method": "expectedImplementation",
    "address": "0xEaa4d032908A9734a2c7939c0D211c35ad51eb31"
  },
  {
    "from": "poolOwner",
    "method": "factory",
    "address": "0xF5A3A153164791AB579C3d9ba5DBECf7cDfd300c"
  },
  {
    "from": "burner",
    "method": "poolManager",
    "address": "0x000000000004444c5dc75cB358380D2e3dE08A90"
  },
  {
    "from": "burner",
    "method": "hook",
    "address": "0xF4B101Ea2008a01F7944B019109E7D22095Ea0cC"
  },
  {
    "from": "burner",
    "method": "token",
    "address": "0x0Bbac44597b1cE9A212C00D46874ee74500D9bE2"
  }
] as const;
