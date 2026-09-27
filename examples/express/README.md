# awesome-node-checkout Express Example

This is a complete reference application demonstrating how to integrate `awesome-node-checkout` into an Express application.

## Features
- **Express 5** server with pre-configured checkout routes via `createCheckoutRouter`
- **SQLite transaction store** (`sqlite-store.ts`) implementing `ITransactionStore`
- **Providers configured**: PayPal, Nexi, and Satispay
- **Handlebars UI** with interactive test payment forms and result pages
- Docker and docker-compose ready

## Quick Start

1. Install dependencies:
   ```bash
   npm install
   ```

2. Configure environment variables:
   ```bash
   cp .env.example .env
   # Edit .env with your sandbox credentials if needed
   ```

3. Start the application:
   ```bash
   npm start
   ```

4. Open `http://localhost:3001` in your browser.
