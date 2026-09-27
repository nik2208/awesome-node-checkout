document.addEventListener('DOMContentLoaded', function () {
    // Form di pagamento iniziale
    const paymentForm = document.getElementById('paymentForm');
    if (paymentForm) {
        // Quando viene selezionato un provider, aggiorna le URL di ritorno
        const providerSelect = paymentForm.querySelector('#provider');
        if (providerSelect) {
            function updateReturnUrls() {
                const provider = providerSelect.value;
                const returnUrlInput = paymentForm.querySelector('[name="returnUrl"]');
                const cancelUrlInput = paymentForm.querySelector('[name="cancelUrl"]');

                if (returnUrlInput) {
                    // Rimuovi ogni provider precedente e imposta quello nuovo
                    let returnUrl = returnUrlInput.defaultValue || returnUrlInput.value;
                    // Assicuriamoci di avere l'URL originale con il placeholder
                    if (!returnUrl.includes('__provider__')) {
                        returnUrl = returnUrl.replace(/provider=[^&]+/, 'provider=__provider__');
                    }
                    returnUrlInput.value = returnUrl.replace('__provider__', provider);
                }

                if (cancelUrlInput) {
                    // Rimuovi ogni provider precedente e imposta quello nuovo
                    let cancelUrl = cancelUrlInput.defaultValue || cancelUrlInput.value;
                    // Assicuriamoci di avere l'URL originale con il placeholder
                    if (!cancelUrl.includes('__provider__')) {
                        cancelUrl = cancelUrl.replace(/provider=[^&]+/, 'provider=__provider__');
                    }
                    cancelUrlInput.value = cancelUrl.replace('__provider__', provider);
                }

                console.log('URLs aggiornati con provider:', provider);
                console.log('Return URL:', returnUrlInput?.value);
                console.log('Cancel URL:', cancelUrlInput?.value);
            }

            // Salva i valori originali degli URL (con __provider__)
            const returnUrlInput = paymentForm.querySelector('[name="returnUrl"]');
            const cancelUrlInput = paymentForm.querySelector('[name="cancelUrl"]');

            if (returnUrlInput) {
                returnUrlInput.defaultValue = returnUrlInput.value;
            }

            if (cancelUrlInput) {
                cancelUrlInput.defaultValue = cancelUrlInput.value;
            }

            // Aggiorna le URL quando cambia il provider
            providerSelect.addEventListener('change', updateReturnUrls);

            // Aggiorna le URL anche all'inizializzazione
            updateReturnUrls();
        }

        paymentForm.addEventListener('submit', handlePaymentSubmit);
    }

    // Form di conferma
    const confirmForm = document.getElementById('confirmForm');
    if (confirmForm) {
        confirmForm.addEventListener('submit', handleConfirmSubmit);
    }
});

async function handlePaymentSubmit(e) {
    e.preventDefault();

    // Ottieni i valori dei meta tag per l'API key
    const apiKeyHeader = document.querySelector('meta[name="api-key-header"]')?.content;
    const apiKey = document.querySelector('meta[name="api-key"]')?.content;

    if (!apiKeyHeader || !apiKey) {
        console.error('API key configuration missing');
        alert('Errore di configurazione API key');
        return;
    }

    const formData = new FormData(e.target);
    const provider = formData.get('provider');

    try {
        // Prepara i metadata
        const metadata = {
            customerId: formData.get('metadata') || 'HFJNV6UGFUF6W',
            source: 'web'
        };

        // Chiamata per creare il pagamento
        const headers = {
            'Content-Type': 'application/json'
        };
        headers[apiKeyHeader] = apiKey;

        const createResponse = await fetch(`/payments/${provider}`, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({
                amount: parseFloat(formData.get('amount')),
                currency: formData.get('currency'),
                description: formData.get('description'),
                returnUrl: formData.get('returnUrl'),
                cancelUrl: formData.get('cancelUrl'),
                orderId: formData.get('orderId'),
                metadata: metadata
            })
        });

        if (!createResponse.ok) {
            const errorData = await createResponse.json();
            throw new Error(errorData.message || 'Failed to create payment');
        }

        const paymentData = await createResponse.json();

        if (paymentData.success && paymentData.approvalUrl) {
            // Redirect all'URL di approvazione del provider
            window.location.href = paymentData.approvalUrl;
        } else {
            alert('Errore durante la creazione del pagamento');
        }
    } catch (error) {
        console.error('Payment error:', error);
        alert('Si è verificato un errore durante il pagamento: ' + error.message);
    }
}

async function handleConfirmSubmit(e) {
    e.preventDefault();

    const paymentId = e.target.querySelector('[name="paymentId"]').value;
    const provider = e.target.querySelector('[name="provider"]').value;

    const apiKeyHeader = document.querySelector('meta[name="api-key-header"]')?.content;
    const apiKey = document.querySelector('meta[name="api-key"]')?.content;

    if (!apiKeyHeader || !apiKey) {
        console.error('API key configuration missing');
        alert('Errore di configurazione API key');
        return;
    }

    try {
        const headers = {
            'Content-Type': 'application/json'
        };
        headers[apiKeyHeader] = apiKey;

        console.log('Executing payment for provider:', provider);
        const executeResponse = await fetch(`/payments/${provider}/execute`, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({
                paymentId: paymentId
            })
        });

        if (!executeResponse.ok) {
            const errorData = await executeResponse.json();
            throw new Error(errorData.message || 'Failed to execute payment');
        }

        const executeData = await executeResponse.json();

        if (executeData.success) {
            window.location.href = `/success?provider=${provider}`;
        } else {
            throw new Error(executeData.error || 'Payment execution failed');
        }
    } catch (error) {
        console.error('Payment execution error:', error);
        alert('Si è verificato un errore durante l\'esecuzione del pagamento: ' + error.message);
    }
}