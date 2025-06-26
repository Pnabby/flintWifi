// Only frontend logic (no API keys)
const plans = {
  daily: { amount: 4, name: "daily" },
  weekly: { amount: 25, name: "weekly" },
  monthly: { amount: 100, name: "monthly" }
};

let selectedPlan = null;

function selectPlan(planType) {
  selectedPlan = plans[planType];
  document.getElementById('emailModal').style.display = 'flex';
}

function closeModal() {
  document.getElementById('emailModal').style.display = 'none';
}

function closeCredentialsModal() {
  document.getElementById('credentialsModal').style.display = 'none';
}