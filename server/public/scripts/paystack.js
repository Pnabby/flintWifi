let pendingVerification = null;
let verificationInFlight = false;
let verificationSucceeded = false;

function openVerifyRetryModal(message, reference) {
  const modal = document.getElementById('verifyRetryModal');
  const messageEl = document.getElementById('verifyRetryMessage');
  const referenceEl = document.getElementById('verifyRetryReference');

  if (messageEl) messageEl.textContent = message || 'Payment verification failed. Please try again.';
  if (referenceEl) {
    if (reference) {
      referenceEl.textContent = `Reference: ${reference}`;
      referenceEl.style.display = 'block';
    } else {
      referenceEl.textContent = '';
      referenceEl.style.display = 'none';
    }
  }

  if (modal) modal.style.display = 'flex';
}

function closeVerifyRetryModal() {
  const modal = document.getElementById('verifyRetryModal');
  if (modal) modal.style.display = 'none';
}

function retryVerifyPayment() {
  if (!pendingVerification) {
    alert('No payment to retry verification for.');
    return;
  }
  closeVerifyRetryModal();
  verifyPayment(pendingVerification);
}

function openVerifyFromRetry() {
  closeVerifyRetryModal();
  if (typeof openVerifyModal === 'function') {
    openVerifyModal({
      email: pendingVerification?.email,
      reference: pendingVerification?.reference
    });
  }
}

async function verifyPayment(payload) {
  pendingVerification = payload;
  if (typeof closeModal === 'function') {
    closeModal();
  }
  verificationInFlight = true;
  document.getElementById('loadingModal').style.display = 'flex';

  try {
    const response = await fetch('/api/verify-payment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    let result = null;
    try {
      result = await response.json();
    } catch (parseError) {
      result = null;
    }

    document.getElementById('loadingModal').style.display = 'none';

    if (!response.ok) {
      openVerifyRetryModal(result?.error || 'Payment verification failed. Please try again.', payload.reference);
      return;
    }

    if (result && result.success) {
      verificationSucceeded = true;
      closeModal(); // hide email modal

      if (result.redirectUrl) {
        window.location.href = result.redirectUrl;
      } else if (result.credentials) {
        // show credentials modal as fallback
        document.getElementById('displayUsername').textContent = result.credentials.username;
        document.getElementById('displayPassword').textContent = result.credentials.password;
        document.getElementById('credentialsModal').style.display = 'flex';
      }
      return;
    }

    openVerifyRetryModal(result?.error || 'Failed to fetch credentials', payload.reference);
  } catch (err) {
    document.getElementById('loadingModal').style.display = 'none';
    console.error('Verification error:', err);
    openVerifyRetryModal('Payment verification failed. Please try again.', payload.reference);
  } finally {
    verificationInFlight = false;
  }
}

async function processPayment() {
  if (!selectedPlan || !selectedPlan.plan_type) {
    alert('No plan selected or invalid plan data');
    return;
  }

  const customerEmail = document.getElementById('customerEmail').value.trim();
  if (!customerEmail || !/^\S+@\S+\.\S+$/.test(customerEmail)) {
    alert('Please enter a valid email address');
    return;
  }

  try {
    // show loading while preparing init data
    document.getElementById('loadingModal').style.display = 'flex';

    // Ask backend for PUBLIC key, amount, ref, split_code (no server init!)
    const response = await fetch('/api/init-payment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: customerEmail,
        planType: selectedPlan.plan_type
      })
    });

    const paymentData = await response.json();

    // stop loading before opening the modal
    document.getElementById('loadingModal').style.display = 'none';

    if (!response.ok || paymentData.error) {
      console.error('Init error:', paymentData.error || response.statusText);
      alert(paymentData.error || 'Payment could not start. Try again.');
      return;
    }

    if (!paymentData.key) {
      console.error('Missing PUBLIC key in response');
      alert('Payment could not start: missing Paystack PUBLIC key');
      return;
    }

    // Inline callback → verify on server
    const handlePaymentCallback = function (resp) {
      verifyPayment({
        reference: resp.reference,
        email: customerEmail,
        planType: selectedPlan.plan_type,
        amount: parseFloat(selectedPlan.amount)
      });
    };

    // Open Paystack Inline (this is where “valid key” matters)
    const verificationPayload = {
      reference: paymentData.reference,
      email: customerEmail,
      planType: selectedPlan.plan_type,
      amount: parseFloat(selectedPlan.amount)
    };

    pendingVerification = verificationPayload;
    verificationInFlight = false;
    verificationSucceeded = false;

    const handler = PaystackPop.setup({
      key: paymentData.key,                 // pk_…
      email: paymentData.email,
      amount: paymentData.amount,
      currency: 'GHS',
      ref: paymentData.reference,
      split_code: paymentData.split_code,   // 👈 include your split group
      metadata: paymentData.metadata,
      callback: handlePaymentCallback,
      onClose: function () {
        // user closed modal → ensure loading is hidden
        document.getElementById('loadingModal').style.display = 'none';
        if (!verificationInFlight && !verificationSucceeded && pendingVerification) {
          openVerifyRetryModal(
            'Payment window closed. If you completed payment, retry verification.',
            pendingVerification.reference
          );
        }
      }
    });

    handler.openIframe();
  } catch (error) {
    document.getElementById('loadingModal').style.display = 'none';
    console.error('Payment error:', error);
    alert('Payment failed. Please try again.');
  }
}
