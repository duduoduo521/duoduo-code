try {
  const cs = await import("cross-spawn")
  console.log("CROSS_OK", typeof cs)
} catch (e) {
  console.log("CROSS_ERR", e.message)
}
try {
  const o = await import("@hey-api/openapi-ts")
  console.log("OAT_OK", typeof o.createClient)
} catch (e) {
  console.log("OAT_ERR", e.message)
}
