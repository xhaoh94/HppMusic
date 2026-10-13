/* 文件读写交给原生 bridge；不能用空函数伪装成功。 */
const unsupported = (operation) => {
  throw new Error(`[mobile] fs.${operation} 不支持：请通过原生 bridge 提供文件数据`);
};

module.exports = {
  existsSync: () => unsupported('existsSync'),
  readFileSync: () => unsupported('readFileSync'),
  createReadStream: () => unsupported('createReadStream'),
};
module.exports.__esModule = true;
