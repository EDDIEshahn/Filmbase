// Prices in Ugandan shillings, billed every 30 days.
const PLANS = {
  basic: { id: 'basic', name: 'Basic', priceUGX: 5000, maxQuality: 480, screens: 1 },
  standard: { id: 'standard', name: 'Standard', priceUGX: 10000, maxQuality: 720, screens: 2 },
  premium: { id: 'premium', name: 'Premium', priceUGX: 20000, maxQuality: 1080, screens: 4 }
};

// Ascending order matters: the stream route picks the highest source at or below the request.
const QUALITIES = [480, 720, 1080];

const getPlan = id => (Object.prototype.hasOwnProperty.call(PLANS, id) ? PLANS[id] : null);
const planList = () => Object.values(PLANS);

module.exports = { PLANS, QUALITIES, getPlan, planList };
