// Minimal type declarations for the deprecated @paypal/checkout-server-sdk package.
// The official replacement is @paypal/paypal-server-sdk.
declare module '@paypal/checkout-server-sdk' {
  namespace core {
    class SandboxEnvironment {
      constructor(clientId: string, clientSecret: string);
    }
    class LiveEnvironment {
      constructor(clientId: string, clientSecret: string);
    }
    class PayPalHttpClient {
      constructor(environment: SandboxEnvironment | LiveEnvironment);
      execute(request: any): Promise<{ result: any }>;
    }
  }
  namespace orders {
    class OrdersCreateRequest {
      prefer(preference: string): void;
      requestBody(body: any): void;
    }
    class OrdersCaptureRequest {
      constructor(orderId: string);
    }
    class OrdersGetRequest {
      constructor(orderId: string);
    }
  }
}
