// One origin for the whole backend. Deriving the websocket URL from it keeps
// the two schemes in step, so an https page cannot end up opening a plain ws://
// socket that the browser will block.
//
// VITE_BACKEND_URL names the origin outright. With only VITE_BACKEND_PORT set,
// the API is taken to be on the page's own host at that port, which is what a
// preview reached by more than one hostname needs.
const explicit = import.meta.env.VITE_BACKEND_URL;
const port = import.meta.env.VITE_BACKEND_PORT;
const BACKEND_URL =
  explicit || (port ? `${window.location.protocol}//${window.location.hostname}:${port}` : "http://localhost:8080");

export const API_BASE_URL = `${BACKEND_URL}/api`;
export const BACKEND_ORIGIN = BACKEND_URL;
export const WS_BASE_URL = BACKEND_URL.replace(/^http/, "ws");

// How people sign in. "clerk" unless the build says demo, which is a local
// stand-in for a demonstration and matches AUTH_MODE=demo on the API.
export const AUTH_MODE: "clerk" | "demo" = import.meta.env.VITE_AUTH_MODE === "demo" ? "demo" : "clerk";
