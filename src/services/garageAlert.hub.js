const { EventEmitter } = require("events");

/** In-process fan-out so SSE / live clients get alerts instantly. */
class GarageAlertHub extends EventEmitter {
  broadcast(alert) {
    this.emit("alert", alert);
  }
}

const garageAlertHub = new GarageAlertHub();

module.exports = { garageAlertHub };
