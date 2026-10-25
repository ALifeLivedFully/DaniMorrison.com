/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

export default {
  async fetch(request) {
    if (request.method !== "POST") {
      return new Response("Ready to receive form submissions!");
    }

    const data = await request.formData();

    for (const [key, value] of data) {
      console.log(`${key}: ${value}`);
    }

    return new Response("Form received. Check the Wrangler terminal.");
  },
};
