// Updated index.js to add retry logic for 503 errors

async function fetchEndpoint(endpoint) {
    let retries = 3;
    while (retries > 0) {
        try {
            const response = await fetch(endpoint);
            if (response.status === 503) {
                throw new Error('Service unavailable');
            }
            return await response.json();
        } catch (error) {
            if (error.message === 'Service unavailable') {
                retries -= 1;
                console.log(`Retrying ${endpoint}. Attempts left: ${retries}`);
                await new Promise(resolve => setTimeout(resolve, 1000)); // Delay before retrying
            } else {
                console.error(`Failed to fetch ${endpoint}:`, error);
                break; // Stop retries on other errors
            }
        }
    }
}

async function processEndpoints(endpoints) {
    for (const endpoint of endpoints) {
        await fetchEndpoint(endpoint);
    }
}

// Example usage
const endpoints = ['https://api.example.com/endpoint1', 'https://api.example.com/endpoint2'];
processEndpoints(endpoints);
