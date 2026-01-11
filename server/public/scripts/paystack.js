let lastVerificationPayload = null;

function showRetryModal(message) {
  const messageEl = document.getElementById('retryVerifyMessage');
  if (messageEl) {
    messageEl.textContent = message || 'Verification is taking longer than usual. Please retry in a moment.';
  }
  document.getElementById('retryVerifyModal').style.display = 'flex';
}

function closeRetryModal() {
  document.getElementById('retryVerifyModal').style.display = 'none';
}

function handleVerificationSuccess(result) {
  closeModal(); // hide email modal

  if (result.redirectUrl) {
    window.location.href = result.redirectUrl;
    return;
  }

  if (result.credentials) {
    // show credentials modal as fallback
    document.getElementById('displayUsername').textContent = result.credentials.username;
    document.getElementById('displayPassword').textContent = result.credentials.password;
    document.getElementById('credentialsModal').style.display = 'flex';
  } else {
    alert('Payment verified but no credentials were returned. Please check your email.');
  }
}

async function verifyPayment(payload) {
  lastVerificationPayload = payload;

  // show loading while verifying
  document.getElementById('loadingModal').style.display = 'flex';

  try {
    const response = await fetch('/api/verify-payment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const result = await response.json();
    document.getElementById('loadingModal').style.display = 'none';

    if (result.success) {
      handleVerificationSuccess(result);
      return;
    }

    if (result.pending) {
      showRetryModal(result.message || 'Payment is still processing. Please retry verification shortly.');
      return;
    }

    showRetryModal(result.error || 'Payment verification failed. Please retry in a moment.');
  } catch (err) {
    document.getElementById('loadingModal').style.display = 'none';
    console.error('Verification error:', err);
    showRetryModal('Verification failed due to a network issue. Please retry.');
  }
}

function retryVerifyPayment() {
  if (!lastVerificationPayload) {
    alert('No pending verification found. Please contact support or use manual verification.');
    return;
  }
  closeRetryModal();
  verifyPayment(lastVerificationPayload);
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
      }
    });

    handler.openIframe();
  } catch (error) {
    document.getElementById('loadingModal').style.display = 'none';
    console.error('Payment error:', error);
    alert('Payment failed. Please try again.');
  }
}
