// __mocks__/@react-native-community/netinfo.js
// Manual Jest mock for @react-native-community/netinfo. Jest applies node_modules
// manual mocks automatically (no jest.mock(...) call needed), so saveRequest.ts can
// import NetInfo in the JS test environment where the native module cannot load.
//
// saveRequest tests inject `netInfoFetch` directly, so this stub exists mainly for
// module resolution; its default fetch() returns a benign "unknown" connection state.

const defaultState = {
  type: "unknown",
  isInternetReachable: null,
  details: {},
};

const NetInfo = {
  fetch: jest.fn(() => Promise.resolve(defaultState)),
  addEventListener: jest.fn(() => jest.fn()), // returns the unsubscribe fn
};

module.exports = NetInfo;
module.exports.default = NetInfo;
