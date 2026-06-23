// jest.setup.js
// Jest setup run before the test suite (registered via the jest.setupFiles config in
// package.json). react-native-keyboard-controller is a native module that jest-expo
// cannot resolve in the JS test environment; its official mock replaces the native
// pieces with no-op JS implementations so any test that imports a screen using
// KeyboardAwareScrollView / KeyboardProvider (transitively) doesn't crash.
require("react-native-keyboard-controller/jest");
