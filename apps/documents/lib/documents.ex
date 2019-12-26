#
#  documents.ex
#  lib
# 
#  Created by Wess Cope (me@wess.io) on 12/12/19
#  Copyright 2019 Wess Cope
#

defmodule Documents do
  use Router

  alias Provider.Document, as: Docs

  plug :match
  plug :dispatch

  get "/" do
    conn
    |> json(200, Docs.all())
  end

  get "/:name" do
    case Docs.get(name: name) do
      nil ->
        conn
        |> json(404, %{error: "Document #{name} not found"})
      doc ->
        conn
        |> json(200, doc)
    end
  end

  post "/" do
    case conn.body_params |> changeset_params |> Docs.create() do
      {:ok, doc} ->
        conn
        |> json(200, doc)
      {:error, changeset} ->
        conn
        |> json(400, %{errors: parse_errors(changeset)})
    end
  end

  delete "/:name" do
    case Docs.get(name: name) do
      nil -> 
        conn
        |> json(404, %{error: "Document #{name} not found"})
      doc ->
        Docs.delete(doc: doc)
    end
  end

  forward "/:name/entities", to: Entities

  match _ do
    conn
    |> json(404, %{error: "not found"})
  end
end
