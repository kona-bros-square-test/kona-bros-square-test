# Kona Bros Coffee — Square Sandbox Test

Public Square credentials already configured in the app:
- Sandbox Application ID: `sandbox-sq0idb-VGjxNH5ZqZsC7EADv8ZyXA`
- Sandbox Location ID: `L864YNVDSF8ZK`

## Run locally
1. Install Node.js 18+.
2. Copy `.env.example` to `.env`.
3. Put the PRIVATE Square Sandbox Access Token in `.env`.
4. Run `npm install`.
5. Run `npm start`.
6. Open `http://localhost:3000`.
7. Go to **Order** and use the **Square Sandbox Connection** card form.

This test endpoint always requests a $1.00 Sandbox payment. It does not charge real money.

## Important
The access token stays server-side in `.env`. Do not put it in the HTML/JavaScript and do not commit `.env` to source control.
