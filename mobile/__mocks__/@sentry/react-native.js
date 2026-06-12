// __mocks__/@sentry/react-native.js
// Manual Jest mock for @sentry/react-native. Jest applies node_modules manual
// mocks automatically (no jest.mock("@sentry/react-native") call needed), so every
// test runs against this lightweight stub instead of the real native SDK — which
// cannot load in the JS test environment.
//
// All entry points are jest.fn() spies (or simple stubs) so tests can assert on
// Sentry.logger.*, Sentry.setUser, Sentry.captureException, etc. jest.clearAllMocks()
// in a test's beforeEach resets them between cases.

const React = require("react");

const logger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

// Functional stand-in for Sentry.ErrorBoundary that mirrors its contract: render
// children normally, and on a thrown render error render the `fallback` render-prop
// with { error, componentStack, eventId, resetError }. Lets us test our wrapper's
// recovery UI without the real SDK.
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.resetError = this.resetError.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  resetError() {
    this.setState({ error: null });
  }

  render() {
    if (this.state.error) {
      const fallback = this.props.fallback;
      return typeof fallback === "function"
        ? fallback({
            error: this.state.error,
            componentStack: "",
            eventId: "",
            resetError: this.resetError,
          })
        : fallback;
    }
    return this.props.children;
  }
}

module.exports = {
  init: jest.fn(),
  // wrap is an HOC in the real SDK; here it returns the component untouched.
  wrap: (component) => component,
  ErrorBoundary,
  reactNavigationIntegration: jest.fn(() => ({
    registerNavigationContainer: jest.fn(),
  })),
  mobileReplayIntegration: jest.fn(() => ({ name: "MobileReplay" })),
  browserReplayIntegration: jest.fn(() => ({ name: "BrowserReplay" })),
  setUser: jest.fn(),
  captureException: jest.fn(),
  logger,
};
