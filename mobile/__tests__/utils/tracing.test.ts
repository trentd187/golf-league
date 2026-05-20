// __tests__/utils/tracing.test.ts
// Unit tests for initWebTracing() in utils/tracing.ts.
// All tests are Tier 1 — no browser, no network, no native device required.
// All OTel SDK packages and react-native are mocked so only the wiring logic is tested.

// Mock constructors captured at module scope so assertions can inspect calls across tests.
// In OTel SDK v2 the provider constructor accepts spanProcessors in its config; there is
// no addSpanProcessor method. mockRegister captures the register() call.
const mockRegister = jest.fn();
const MockWebTracerProvider = jest.fn(() => ({
  register: mockRegister,
}));
const MockBatchSpanProcessor = jest.fn();
const MockOTLPTraceExporter = jest.fn();
const mockRegisterInstrumentations = jest.fn();
const MockFetchInstrumentation = jest.fn();
const MockDocumentLoadInstrumentation = jest.fn();
const MockW3CTraceContextPropagator = jest.fn();

jest.mock("@opentelemetry/sdk-trace-web", () => ({
  WebTracerProvider: MockWebTracerProvider,
}));
jest.mock("@opentelemetry/sdk-trace-base", () => ({
  BatchSpanProcessor: MockBatchSpanProcessor,
}));
jest.mock("@opentelemetry/exporter-trace-otlp-http", () => ({
  OTLPTraceExporter: MockOTLPTraceExporter,
}));
jest.mock("@opentelemetry/instrumentation", () => ({
  registerInstrumentations: mockRegisterInstrumentations,
}));
jest.mock("@opentelemetry/instrumentation-fetch", () => ({
  FetchInstrumentation: MockFetchInstrumentation,
}));
jest.mock("@opentelemetry/instrumentation-document-load", () => ({
  DocumentLoadInstrumentation: MockDocumentLoadInstrumentation,
}));
jest.mock("@opentelemetry/core", () => ({
  W3CTraceContextPropagator: MockW3CTraceContextPropagator,
}));

// Default Platform.OS to 'web'; individual tests override via jest.doMock + isolateModules.
jest.mock("react-native", () => ({ Platform: { OS: "web" } }));

// freshTracing loads tracing.ts from a clean module instance with the given platform.
// jest.isolateModules resets the module registry for the callback so the module-level
// `initialized` flag starts as false on every call.
function freshTracing(platformOS: string): { initWebTracing: () => void } {
  let mod!: { initWebTracing: () => void };
  jest.isolateModules(() => {
    jest.doMock("react-native", () => ({ Platform: { OS: platformOS } }));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    mod = require("@/utils/tracing");
  });
  return mod;
}

beforeEach(() => {
  jest.clearAllMocks();
  // jsdom sets window.location.href to "about:blank"; give it a realistic origin.
  Object.defineProperty(window, "location", {
    value: { origin: "https://golf-web.example.com" },
    writable: true,
    configurable: true,
  });
});

describe("initWebTracing", () => {
  it("does nothing on native platforms", () => {
    const { initWebTracing } = freshTracing("android");
    initWebTracing();
    expect(MockWebTracerProvider).not.toHaveBeenCalled();
    expect(MockOTLPTraceExporter).not.toHaveBeenCalled();
    expect(mockRegisterInstrumentations).not.toHaveBeenCalled();
  });

  it("creates an OTLPTraceExporter targeting the same-origin OTLP path", () => {
    const { initWebTracing } = freshTracing("web");
    initWebTracing();
    expect(MockOTLPTraceExporter).toHaveBeenCalledWith({
      url: "https://golf-web.example.com/otlp/v1/traces",
    });
  });

  it("creates a WebTracerProvider with a BatchSpanProcessor and registers it", () => {
    const { initWebTracing } = freshTracing("web");
    initWebTracing();
    expect(MockBatchSpanProcessor).toHaveBeenCalledTimes(1);
    // In OTel SDK v2 spanProcessors is passed to the constructor, not addSpanProcessor().
    expect(MockWebTracerProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        spanProcessors: expect.arrayContaining([expect.any(Object)]),
      })
    );
    expect(mockRegister).toHaveBeenCalledWith(
      expect.objectContaining({ propagator: expect.any(Object) })
    );
  });

  it("registers FetchInstrumentation and DocumentLoadInstrumentation", () => {
    const { initWebTracing } = freshTracing("web");
    initWebTracing();
    expect(MockFetchInstrumentation).toHaveBeenCalledTimes(1);
    expect(MockDocumentLoadInstrumentation).toHaveBeenCalledTimes(1);
    expect(mockRegisterInstrumentations).toHaveBeenCalledWith(
      expect.objectContaining({
        instrumentations: expect.arrayContaining([
          expect.any(Object),
          expect.any(Object),
        ]),
        tracerProvider: expect.any(Object),
      })
    );
  });

  it("is idempotent — second call within the same module instance is a no-op", () => {
    const { initWebTracing } = freshTracing("web");
    initWebTracing();
    initWebTracing();
    expect(MockWebTracerProvider).toHaveBeenCalledTimes(1);
    expect(mockRegisterInstrumentations).toHaveBeenCalledTimes(1);
  });

  it("uses W3CTraceContextPropagator for the provider", () => {
    const { initWebTracing } = freshTracing("web");
    initWebTracing();
    expect(MockW3CTraceContextPropagator).toHaveBeenCalledTimes(1);
    expect(mockRegister).toHaveBeenCalledWith(
      expect.objectContaining({ propagator: expect.any(MockW3CTraceContextPropagator) })
    );
  });
});
