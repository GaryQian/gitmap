"""Command-line client. A docstring import does not count: import ghost_pb2"""
import grpc

from inventory.v1 import stock_pb2, stock_pb2_grpc
import invoice_items_pb2
from common import types_pb2 as money
# Two files are called types.proto: without a directory this names neither.
import types_pb2


def main():
    channel = grpc.insecure_channel("localhost:50051")
    stub = stock_pb2_grpc.StockServiceStub(channel)
    print(stub.GetStock(stock_pb2.StockRequest(sku="a-1")), invoice_items_pb2, money, types_pb2)
