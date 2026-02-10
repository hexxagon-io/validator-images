// Updated index.js to include retry logic for 503 errors

const axios = require('axios');

const MAX_RETRIES = 3;

async function fetchData(endpoint, retries = MAX_RETRIES) {
    try {
        const response = await axios.get(endpoint);
        return response.data;
    } catch (error) {
        if (error.response && error.response.status === 503 && retries > 0) {
            console.log(`503 error encountered. Retrying... (${MAX_RETRIES - retries + 1}/${MAX_RETRIES})`);
            return fetchData(endpoint, retries - 1);
        } else {
            console.error(`Error fetching data from ${endpoint}:`, error.message);
            return null; // Continue processing other endpoints on failure
        }
    }
}

async function processEndpoints(endpoints) {
    for (const endpoint of endpoints) {
        const data = await fetchData(endpoint);
        if (data) {
            console.log(`Data from ${endpoint}:`, data);
        } else {
            console.log(`Failed to fetch data from ${endpoint}, continuing to next.`);
        }
    }
}

const endpoints = [
    'https://api.example.com/endpoint1',
    'https://api.example.com/endpoint2',
    // Add more endpoints as needed
];

processEndpoints(endpoints);