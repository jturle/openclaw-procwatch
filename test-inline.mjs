// Quick inline test of the pattern matching and webhook call
const token = "06e50dae908d0a83c45bffa01173080cdeda5d3fbc91efc7";
const patterns = [
  { regex: "error|Error|ERROR", label: "Error", contextLines: 15 },
];

const testLine = "ERROR: Something went wrong!";

for (const pattern of patterns) {
  const re = new RegExp(pattern.regex, "i");
  console.log(`Testing pattern "${pattern.regex}" against "${testLine}": ${re.test(testLine)}`);
}

// Test webhook
console.log("\nTesting webhook call...");
const res = await fetch("http://127.0.0.1:18789/hooks/agent", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${token}`,
  },
  body: JSON.stringify({
    message: "Inline test: ERROR detected",
    name: "ProcWatch:InlineTest",
    wakeMode: "now",
  }),
});
console.log("Response:", res.status, await res.text());
