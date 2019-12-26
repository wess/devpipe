#
#  entities.ex
#  lib
# 
#  Created by Wess Cope (me@wess.io) on 12/13/19
#  Copyright 2019 Wess Cope
#

defmodule Entities do
  use Router

  alias Provider.Entity,    as: Ents
  alias Provider.Document,  as: Docs

  plug :match
  plug :dispatch

  get "/" do
    case Docs.get(name: conn.params["name"]) do
      nil ->
        conn
        |> json(404, %{status: "error", error: "Unable to find document #{conn.params["name"]}"})
      doc ->
        conn
        |> json(200, %{
            status:     "success", 
            document:     doc, 
            documents:  Ents.list(doc: doc)
          })
    end
  end

  get "/search" do
    case Docs.get(name: conn.params["name"]) do
      nil ->
        conn
        |> json(404, %{status: "error", error: "Unable to find document #{conn.params["name"]}"})
      doc ->
        conn
        |> json(200, %{
            status:   "success", 
            document: doc,
            entites:  Ents.search(doc, conn.query_params)
          })
    end

  end

  get "/:id" do
    case Ents.get(id: id) do
      nil ->
        conn
        |> json(404, %{status: "error", error: "Unable to find entity with id: #{id}"})
      entity ->
        conn
        |> json(200, entity)
    end
  end

  post "/" do
    case Docs.get(name: conn.params["name"]) do
      nil ->
        conn
        |> json(404, %{error: "Unable to find document #{conn.params["name"]}"})
      doc ->
        conn
        |> json(200, %{
            :document => doc, 
          } |> Map.merge(create_entity(doc, conn.body_params)))
    end

  end


  delete "/:id" do
    case Ents.get(id: id) do
      nil ->
        conn
        |> json(404, %{status: "error", error: "Unable to find entity with id: #{id}"})

      ent -> 
        Ents.delete(entity: ent)

        conn
        |> json(200, %{})
    end
  end


  match _ do
    conn
    |> json(404, %{error: "not found"})
  end


  ###
  defp create_entity(document, params) do
    case document |> Ents.create(changeset_params(params)) do
      {:error, changeset} ->
        %{errors: parse_errors(changeset)}
      {:ok, entity} ->
        entity
    end
  end

end
