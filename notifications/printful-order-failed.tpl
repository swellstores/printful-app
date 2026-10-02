<!doctype html>
<html xmlns="http://www.w3.org/1999/xhtml">

<head>
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style type="text/css">
    body {
      margin: 0;
      padding: 0;
      -webkit-text-size-adjust: 100%;
    }

    p {
      display: block;
      margin: 0 0 13px 0;
    }

    .error {
      padding: 12px;
      background: #f6f6f6;
      font-family: monospace;
      white-space: pre-wrap;
    }
  </style>
</head>

<body style="word-spacing:normal;">
  <div>
    <p>Order <a href="{{ store.admin_url }}/orders/{{ order_id }}">{{ order.number }}</a> was not fulfilled by Printful.</p>

    <p class="error">{{ last_error }}</p>

    {%- if printful_order_id -%}
      <p>The Printful order is <a href="https://www.printful.com/dashboard/order/{{ printful_order_id }}">{{ printful_order_id }}</a>.</p>
    {%- else -%}
      <p>No Printful order was created. The job gave up after {{ attempts }} attempts.</p>
    {%- endif -%}

    <p>Printful validates print files after an order is confirmed, so an order can be accepted and then fail. Fix the cause, then set the fulfillment job back to Pending under Orders &rarr; Printful fulfillments to retry it.</p>
  </div>
</body>

</html>
