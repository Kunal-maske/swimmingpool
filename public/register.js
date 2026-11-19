const API_URL = "";

const photoInput = document.getElementById("photo");
const photoPreview = document.getElementById("photoPreview");
const dateOfBirthInput = document.getElementById("dateOfBirth");
const accountType = document.body.dataset.accountType;

dateOfBirthInput.max = new Date().toISOString().slice(0, 10);

photoInput.addEventListener("change", (event) => {
  const file = event.target.files[0];
  if (!file) {
    photoPreview.replaceChildren();
    return;
  }

  const reader = new FileReader();
  reader.onload = (loadEvent) => {
    const image = document.createElement("img");
    image.src = loadEvent.target.result;
    image.alt = "Profile photo preview";
    photoPreview.replaceChildren(image);
  };
  reader.readAsDataURL(file);
});

document.getElementById("registerForm").addEventListener("submit", async (event) => {
  event.preventDefault();

  const formData = new FormData(event.currentTarget);
  const endpoint = accountType === "outside"
    ? "/api/register/outside"
    : "/api/register";

  try {
    const response = await fetch(endpoint, { method: "POST", body: formData });
    const data = await response.json();

    if (!response.ok) {
      document.getElementById("message").innerHTML =
        `<div class="alert alert-error">${escapeHtml(data.error)}</div>`;
      return;
    }

    localStorage.setItem("token", data.token);
    localStorage.setItem("user", JSON.stringify(data.user));
    document.getElementById("message").innerHTML =
      '<div class="alert alert-success">Registration successful! Redirecting to dashboard...</div>';
    setTimeout(() => (window.location.href = "dashboard.html"), 2000);
  } catch (error) {
    console.error(error);
    document.getElementById("message").innerHTML =
      '<div class="alert alert-error">Registration failed. Please try again.</div>';
  }
});
