exports.success = (res, data, message = "Success") => {
  return res.status(200).json({
    success: true,
    message,
    data,
  });
};

exports.error = (res, message = "Something went wrong") => {
  return res.status(500).json({
    success: false,
    message,
  });
};