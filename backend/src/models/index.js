// Single import point for every model, so callers never reach into file paths.
module.exports = {
  User: require("./user"),
  EmailAccount: require("./emailAccount"),
  EmailLeadList: require("./emailLeadList"),
  EmailLead: require("./emailLead"),
  EmailCampaign: require("./emailCampaign"),
  EmailMessage: require("./emailMessage"),
  EmailImage: require("./emailImage"),
};
