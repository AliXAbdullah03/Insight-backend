const { EventEmitter } = require("events");

/** In-process fan-out so SSE / live clients get alerts instantly, scoped by org. */
class GarageAlertHub extends EventEmitter {
  broadcast(alert, orgToken) {
    this.emit("alert", alert, orgToken || alert?.org_token || null);
    if (orgToken || alert?.org_token) {
      this.emit(`alert:${orgToken || alert.org_token}`, alert);
    }
  }
}

const garageAlertHub = new GarageAlertHub();

module.exports = { garageAlertHub };
