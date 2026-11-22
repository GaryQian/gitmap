// The stubs are generated into ./gen, which is not checked in.
import { StockReply, StockRequest } from './gen/inventory/v1/stock_pb';
import { StockServiceService } from './gen/inventory/v1/stock_grpc_pb.js';
import { Money } from './gen/legacy/types_pb';
import { log } from './log';

export function getStock(request: StockRequest): StockReply {
  log(String(StockServiceService), Money);
  const reply = new StockReply();
  reply.setCount(request.getSku().length);
  return reply;
}
