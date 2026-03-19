const express = require("express");
const app = express();

app.get("/", (req, res) => {
  const key = "pK1fTABWxNgpuQ1LRu49gfu5dYcNYxESIYe2zbzI";

  if (key) {
    res.send("API key loaded ✅");
  } else {
    res.send("No API key ❌");
  }
});

app.listen(3000, () => {
  console.log("Server running");
});
