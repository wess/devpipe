#
#  jsonb.ex
#  lib
# 
#  Created by Wess Cope (me@wess.io) on 11/20/19
#  Copyright 2019 Wess Cope
#

defmodule Jsonb do
  import Ecto.Query

  defmacro json_query(qry, col, params, opts) do
    where_type = Keyword.get(opts, :where_type, :where)

    quote do
      Enum.reduce(unquote(params), unquote(qry), fn {key, val}, acc ->
        from(q in acc, [
          {
            unquote(where_type),
            fragment(
              "?::jsonb @> ?::jsonb",
              field(q, ^unquote(col)),
              ^%{to_string(key) => val}
            )
          }
        ])
      end)
    end
	end
end
