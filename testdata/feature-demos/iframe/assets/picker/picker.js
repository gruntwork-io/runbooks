// Show the environment the runbook sends.
window.addEventListener("message", (event) => {
  if (event.data && event.data.type === "runbooks:inputs") {
    document.getElementById("environment").textContent = event.data.inputs.environment
  }
})

// Set the picked region as the block's `region` output.
for (const button of document.querySelectorAll("[data-region]")) {
  button.addEventListener("click", () => {
    const region = button.dataset.region
    parent.postMessage({ type: "runbooks:set-outputs", outputs: { region } }, "*")
    for (const other of document.querySelectorAll("[data-region]")) other.classList.toggle("picked", other === button)
    document.getElementById("status").textContent = `Picked ${region}.`
  })
}
