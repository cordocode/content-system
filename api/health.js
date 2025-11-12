module.exports = async (req, res) => {
  return res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    message: 'Content System API is running'
  });
};