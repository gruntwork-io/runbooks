document.getElementById("status").textContent = "The script ran."

let clicks = 0
const counter = document.getElementById("counter")
counter.addEventListener("click", () => {
  clicks += 1
  counter.textContent = `Clicked ${clicks} times`
})
