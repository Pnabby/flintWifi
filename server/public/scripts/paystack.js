async function processPayment() {
  const customerEmail = document.getElementById('customerEmail').value.trim();

  if (!customerEmail || !/^\S+@\S+\.\S+$/.test(customerEmail)) {
    alert('Please enter a valid email address');
    return;
  }

  try {
    // 1. Get payment data from backend
    const response = await fetch('/api/init-payment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: customerEmail,
        planType: selectedPlan.name
      })
    });
    const paymentData = await response.json();

    // 2. Define a REGULAR (non-async) callback
    const handlePaymentCallback = function(response) {
      // Use .then() instead of async/await
      fetch('/api/verify-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reference: response.reference,
          email: customerEmail,
          planType: selectedPlan.name,
          amount: selectedPlan.amount
        })
      })
      .then(verification => verification.json())
      .then(result => {
        if (result.success) {
          closeModal();
          if (result.redirectUrl) {
            window.location.href = result.redirectUrl;
          } else {
            // Fallback to old modal behavior if redirectUrl isn't available
            document.getElementById('displayUsername').textContent = result.credentials.username;
            document.getElementById('displayPassword').textContent = result.credentials.password;
            document.getElementById('credentialsModal').style.display = 'flex';
          }
        } else {
          alert('Error: ' + (result.error || "Failed to fetch credentials"));
        }
      })
      .catch(error => {
        console.error('Verification error:', error);
        alert('Payment verification failed');
      });
    };

    // 3. Initialize Paystack
    const handler = PaystackPop.setup({
      key: paymentData.key,
      email: paymentData.email,
      amount: paymentData.amount,
      currency: 'GHS',
      ref: paymentData.reference,
      metadata: paymentData.metadata,
      callback: handlePaymentCallback, // Sync function
      onClose: () => console.log('Payment window closed')
    });

    handler.openIframe();
  } catch (error) {
    console.error('Payment error:', error);
    alert('Payment failed. Please try again.');
  }
}