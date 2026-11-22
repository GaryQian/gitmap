package main

import (
	"fmt"

	"example.com/shop/gen/stockpb"
	"google.golang.org/protobuf/proto"
)

func main() {
	fmt.Println(proto.Size(&stockpb.StockRequest{Sku: "a-1"}))
}
