const express = require("express");
const app = express();

app.get("/", (req, res) => {
  const key = process.env.GROCERY_API_KEY;

  if (key) {
    res.send("API key loaded ✅");
  } else {
    res.send("No API key ❌");
  }
});

app.listen(3000, () => {
  console.log("Server running");
});
