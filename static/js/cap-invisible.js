(function () {
  function solve(endpoint) {
    if (!window.Cap || !endpoint) return Promise.reject(new Error("Cap unavailable"));
    var cap = new window.Cap({ apiEndpoint: endpoint });
    return cap.solve().then(function (result) {
      if (!result || !result.token) throw new Error("Cap solve failed");
      return result.token;
    });
  }

  function showError(form) {
    var error = form.querySelector(".checkout-error, .form-error, .cap-error");
    if (!error) {
      error = document.createElement("p");
      error.className = "cap-error";
      error.setAttribute("role", "alert");
      form.appendChild(error);
    }
    error.textContent = "Verification failed. Please try again.";
    error.hidden = false;
  }

  function wire(form) {
    if (form.getAttribute("data-cap-wired") === "true") return;
    form.setAttribute("data-cap-wired", "true");
    form.addEventListener("submit", function (event) {
      if (form.__capResolved) {
        form.__capResolved = false;
        return;
      }
      var field = form.querySelector('input[name="cap-token"]');
      if (!field) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      var button = form.querySelector('button[type="submit"], input[type="submit"]');
      if (button) button.disabled = true;
      solve(form.getAttribute("data-cap-endpoint")).then(function (token) {
        field.value = token;
        if (button) button.disabled = false;
        form.__capResolved = true;
        if (form.requestSubmit) form.requestSubmit();
        else form.submit();
      }).catch(function () {
        if (button) button.disabled = false;
        showError(form);
      });
    }, true);
  }

  window.capInvisible = { solve: solve };

  var forms = document.querySelectorAll("form[data-cap-endpoint]");
  for (var i = 0; i < forms.length; i += 1) wire(forms[i]);
})();
