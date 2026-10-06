// Must be imported first: all day/month boundaries, reports and dashboards run in shop time (IST).
process.env.TZ = process.env.APP_TZ || "Asia/Kolkata";
