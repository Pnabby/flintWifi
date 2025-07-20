let selectedPlan = null;
let availablePlans = [];

// Fetch plans from backend when page loads
document.addEventListener('DOMContentLoaded', async () => {
  try {
    const response = await fetch('/api/plans');
    if (!response.ok) throw new Error('Failed to fetch plans');
    
    availablePlans = await response.json();
    renderPlans(availablePlans);
  } catch (error) {
    console.error('Error loading plans:', error);
    // Fallback to default plans if API fails
    // renderPlans([
    //   { plan_type: 'monthly', amount: 100, description: '30-day unlimited access' },
    //   { plan_type: 'weekly', amount: 25, description: '7-day unlimited access' },
    //   { plan_type: 'daily', amount: 4, description: '24-hour unlimited access' }
    // ]);
  }
});

function renderPlans(plans) {
  const plansContainer = document.querySelector('.plans-container');
  plansContainer.innerHTML = ''; // Clear existing plans

  plans.forEach(plan => {
    const planElement = document.createElement('div');
    planElement.className = 'plan';
    
    // Determine features based on plan type
    let features = [];
    if (plan.plan_type === 'daily') {
      features = [
        '24-hour unlimited access',
        'High-speed connectivity',
        'Two device support',
        'Starter pack'
      ];
    } else if (plan.plan_type === 'weekly') {
      features = [
        '7-day unlimited access',
        'High-speed connectivity',
        'Two device support',
        'Save 10% vs daily plans'
      ];
    } else if (plan.plan_type === 'monthly') {
      features = [
        '30-day unlimited access',
        'High-speed connectivity',
        'Two device support',
        'Best value - save 15%'
      ];
    }
    
    // Use description from database if available
    if (plan.description) {
      features.unshift(plan.description);
    }

    planElement.innerHTML = `
      <div class="plan-header">
        <h2 class="plan-title">${capitalizeFirstLetter(plan.plan_type)} Plan</h2>
        <div class="plan-price">${plan.amount} <span>GHS</span></div>
      </div>
      <ul class="plan-features">
        ${features.map(feature => `<li>${feature}</li>`).join('')}
      </ul>
      <button class="btn" onclick="selectPlan('${plan.plan_type}')">Get ${capitalizeFirstLetter(plan.plan_type)} Plan</button>
    `;
    
    plansContainer.appendChild(planElement);
  });
}

function capitalizeFirstLetter(string) {
  return string.charAt(0).toUpperCase() + string.slice(1);
}

async function manualVerify() {
  const email = prompt("Enter the email you used for payment:");
  if (!email) return;

  const resultDiv = document.getElementById('manualVerifyResult');
  resultDiv.innerHTML = '<div class="loader"></div><p>Checking payment status...</p>';

  try {
    const response = await fetch('/api/manual-verify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email })
    });
    
    const result = await response.json();

    if (result.error) {
      resultDiv.innerHTML = `<p style="color: var(--danger)">${result.error}</p>`;
      return;
    }

    if (result.status === 'exists') {
      resultDiv.innerHTML = `
        <p>Your payment was already processed.</p>
        <p>Reference: ${result.reference}</p>
      `;
    } 
    else if (result.status === 'processed') {
      resultDiv.innerHTML = `
        <p style="color: var(--success)">✓ Payment verified!</p>
        <p>Username: <strong>${result.credentials.username}</strong></p>
        <p>Password: <strong>${result.credentials.password}</strong></p>
        <p>Check your email for these details.</p>
      `;
    }
    else {
      resultDiv.innerHTML = `
        <p>Payment found but not successful yet.</p>
        <p>Status: ${result.message}</p>
        <p>Reference: ${result.reference}</p>
      `;
    }
  } catch (error) {
    resultDiv.innerHTML = `
      <p style="color: var(--danger)">Failed to verify payment</p>
      <p>Please try again later or contact support</p>
    `;
    console.error("Manual verify failed:", error);
  }
}

function selectPlan(planType) {
  selectedPlan = availablePlans.find(plan => plan.plan_type === planType);
  if (selectedPlan) {
    console.log("Selected plan:", selectedPlan); // Debug log
    document.getElementById('emailModal').style.display = 'flex';
  } else {
    console.error("Plan not found for type:", planType);
  }
}

function closeModal() {
  document.getElementById('emailModal').style.display = 'none';
}

function closeCredentialsModal() {
  document.getElementById('credentialsModal').style.display = 'none';
}
function openVerifyModal() {
    document.getElementById('manualVerifyModal').style.display = 'flex';
    document.getElementById('verifyEmail').value = ''; // Clear any previous input
    document.getElementById('manualVerifyResult').innerHTML = ''; // Clear previous results
}

function closeVerifyModal() {
    document.getElementById('manualVerifyModal').style.display = 'none';
}

async function submitManualVerify() {
    const email = document.getElementById('verifyEmail').value;
    if (!email) {
        alert('Please enter your email address');
        return;
    }

    const resultDiv = document.getElementById('manualVerifyResult');
    resultDiv.innerHTML = '<div class="loader"></div><p>Checking payment status...</p>';
    closeVerifyModal();

    try {
        const response = await fetch('/api/manual-verify', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ email })
        });
        
        const result = await response.json();

        if (result.error) {
            resultDiv.innerHTML = `<p style="color: var(--danger)">${result.error}</p>`;
            return;
        }

        if (result.status === 'exists') {
            resultDiv.innerHTML = `
                <p>Your payment was already processed. Please check your email for credentials.</p>
                <p>Reference: ${result.reference}</p>
            `;
        } 
        else if (result.status === 'processed') {
            resultDiv.innerHTML = `
                <p style="color: var(--success)">✓ Payment verified!</p>
                <p>Username: <strong>${result.credentials.username}</strong></p>
                <p>Password: <strong>${result.credentials.password}</strong></p>
                <p>Check your email for these details.</p>
            `;
        }
        else {
            resultDiv.innerHTML = `
                <p>Payment found but not successful yet.</p>
                <p>Status: ${result.message}</p>
                <p>Reference: ${result.reference}</p>
            `;
        }
    } catch (error) {
        resultDiv.innerHTML = `
            <p style="color: var(--danger)">Failed to verify payment</p>
            <p>Please try again later or contact support</p>
        `;
        console.error("Manual verify failed:", error);
    }
}